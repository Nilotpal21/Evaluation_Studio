/**
 * Progress Template Renderer
 *
 * Renders a progress indicator as either a horizontal bar or SVG circle.
 */

import React from 'react';
import type { Message, ProgressTemplate } from '../../core/types.js';
import type { TemplateRenderer, TemplateContext } from '../types.js';
import { defaultRegistry } from '../registry.js';
import { getString } from '../utils/strings.js';

/** Default max value for progress */
const DEFAULT_MAX = 100;

/** SVG circle constants */
const CIRCLE_RADIUS = 36;
const CIRCLE_CX = 40;
const CIRCLE_CY = 40;
const CIRCLE_CIRCUMFERENCE = 2 * Math.PI * CIRCLE_RADIUS;

// ---------------------------------------------------------------------------
// React bar variant
// ---------------------------------------------------------------------------

function ProgressBar(props: { value: number; max: number; label: string }): React.ReactElement {
  const { value, max, label } = props;
  const pct = Math.min(100, Math.max(0, (value / max) * 100));

  return React.createElement(
    'div',
    {
      className: 'rich-progress rich-progress-bar',
      role: 'progressbar',
      'aria-valuenow': value,
      'aria-valuemin': 0,
      'aria-valuemax': max,
      'aria-label': label,
    },
    React.createElement('div', { className: 'rich-progress-label' }, label),
    React.createElement(
      'div',
      { className: 'rich-progress-track' },
      React.createElement('div', {
        className: 'rich-progress-fill',
        style: { width: `${pct}%` },
      }),
    ),
    React.createElement('div', { className: 'rich-progress-value' }, `${Math.round(pct)}%`),
  );
}

// ---------------------------------------------------------------------------
// React circle variant
// ---------------------------------------------------------------------------

function ProgressCircle(props: { value: number; max: number; label: string }): React.ReactElement {
  const { value, max, label } = props;
  const pct = Math.min(100, Math.max(0, (value / max) * 100));
  const dashOffset = CIRCLE_CIRCUMFERENCE - (pct / 100) * CIRCLE_CIRCUMFERENCE;

  return React.createElement(
    'div',
    {
      className: 'rich-progress rich-progress-circle',
      role: 'progressbar',
      'aria-valuenow': value,
      'aria-valuemin': 0,
      'aria-valuemax': max,
      'aria-label': label,
    },
    React.createElement(
      'svg',
      { viewBox: '0 0 80 80', className: 'rich-progress-svg' },
      React.createElement('circle', {
        cx: CIRCLE_CX,
        cy: CIRCLE_CY,
        r: CIRCLE_RADIUS,
        className: 'rich-progress-circle-bg',
        fill: 'none',
        strokeWidth: 6,
      }),
      React.createElement('circle', {
        cx: CIRCLE_CX,
        cy: CIRCLE_CY,
        r: CIRCLE_RADIUS,
        className: 'rich-progress-circle-fill',
        fill: 'none',
        strokeWidth: 6,
        strokeDasharray: CIRCLE_CIRCUMFERENCE,
        strokeDashoffset: dashOffset,
        strokeLinecap: 'round',
        transform: `rotate(-90 ${CIRCLE_CX} ${CIRCLE_CY})`,
      }),
      React.createElement(
        'text',
        {
          x: CIRCLE_CX,
          y: CIRCLE_CY,
          textAnchor: 'middle',
          dominantBaseline: 'central',
          className: 'rich-progress-circle-text',
          fontSize: '14',
        },
        `${Math.round(pct)}%`,
      ),
    ),
    React.createElement('div', { className: 'rich-progress-label' }, label),
  );
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

const progressRenderer: TemplateRenderer<ProgressTemplate> = {
  type: 'progress',

  extract(message: Message): ProgressTemplate | undefined {
    return message.richContent?.progress;
  },

  render(data: ProgressTemplate, _ctx: TemplateContext): React.ReactElement {
    const max = data.max ?? DEFAULT_MAX;
    const label = data.label ?? getString('progress.label');

    if (data.variant === 'circle') {
      return React.createElement(ProgressCircle, { value: data.value, max, label });
    }
    return React.createElement(ProgressBar, { value: data.value, max, label });
  },

  renderDOM(data: ProgressTemplate, _ctx: TemplateContext): HTMLElement {
    const max = data.max ?? DEFAULT_MAX;
    const label = data.label ?? getString('progress.label');
    const pct = Math.min(100, Math.max(0, (data.value / max) * 100));

    if (data.variant === 'circle') {
      return renderCircleDOM(pct, data.value, max, label);
    }
    return renderBarDOM(pct, data.value, max, label);
  },
};

function renderBarDOM(pct: number, value: number, max: number, label: string): HTMLElement {
  const container = document.createElement('div');
  container.className = 'rich-progress rich-progress-bar';
  container.setAttribute('role', 'progressbar');
  container.setAttribute('aria-valuenow', String(value));
  container.setAttribute('aria-valuemin', '0');
  container.setAttribute('aria-valuemax', String(max));
  container.setAttribute('aria-label', label);

  const labelEl = document.createElement('div');
  labelEl.className = 'rich-progress-label';
  labelEl.textContent = label;
  container.appendChild(labelEl);

  const track = document.createElement('div');
  track.className = 'rich-progress-track';
  const fill = document.createElement('div');
  fill.className = 'rich-progress-fill';
  fill.style.width = `${pct}%`;
  track.appendChild(fill);
  container.appendChild(track);

  const valueEl = document.createElement('div');
  valueEl.className = 'rich-progress-value';
  valueEl.textContent = `${Math.round(pct)}%`;
  container.appendChild(valueEl);

  return container;
}

function renderCircleDOM(pct: number, value: number, max: number, label: string): HTMLElement {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const dashOffset = CIRCLE_CIRCUMFERENCE - (pct / 100) * CIRCLE_CIRCUMFERENCE;

  const container = document.createElement('div');
  container.className = 'rich-progress rich-progress-circle';
  container.setAttribute('role', 'progressbar');
  container.setAttribute('aria-valuenow', String(value));
  container.setAttribute('aria-valuemin', '0');
  container.setAttribute('aria-valuemax', String(max));
  container.setAttribute('aria-label', label);

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 80 80');
  svg.setAttribute('class', 'rich-progress-svg');

  const bgCircle = document.createElementNS(SVG_NS, 'circle');
  bgCircle.setAttribute('cx', String(CIRCLE_CX));
  bgCircle.setAttribute('cy', String(CIRCLE_CY));
  bgCircle.setAttribute('r', String(CIRCLE_RADIUS));
  bgCircle.setAttribute('class', 'rich-progress-circle-bg');
  bgCircle.setAttribute('fill', 'none');
  bgCircle.setAttribute('stroke-width', '6');
  svg.appendChild(bgCircle);

  const fillCircle = document.createElementNS(SVG_NS, 'circle');
  fillCircle.setAttribute('cx', String(CIRCLE_CX));
  fillCircle.setAttribute('cy', String(CIRCLE_CY));
  fillCircle.setAttribute('r', String(CIRCLE_RADIUS));
  fillCircle.setAttribute('class', 'rich-progress-circle-fill');
  fillCircle.setAttribute('fill', 'none');
  fillCircle.setAttribute('stroke-width', '6');
  fillCircle.setAttribute('stroke-dasharray', String(CIRCLE_CIRCUMFERENCE));
  fillCircle.setAttribute('stroke-dashoffset', String(dashOffset));
  fillCircle.setAttribute('stroke-linecap', 'round');
  fillCircle.setAttribute('transform', `rotate(-90 ${CIRCLE_CX} ${CIRCLE_CY})`);
  svg.appendChild(fillCircle);

  const text = document.createElementNS(SVG_NS, 'text');
  text.setAttribute('x', String(CIRCLE_CX));
  text.setAttribute('y', String(CIRCLE_CY));
  text.setAttribute('text-anchor', 'middle');
  text.setAttribute('dominant-baseline', 'central');
  text.setAttribute('class', 'rich-progress-circle-text');
  text.setAttribute('font-size', '14');
  text.textContent = `${Math.round(pct)}%`;
  svg.appendChild(text);

  container.appendChild(svg);

  const labelEl = document.createElement('div');
  labelEl.className = 'rich-progress-label';
  labelEl.textContent = label;
  container.appendChild(labelEl);

  return container;
}

defaultRegistry.register(progressRenderer);

export { progressRenderer };
