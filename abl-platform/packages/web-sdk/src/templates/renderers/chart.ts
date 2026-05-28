/**
 * Chart Template Renderer
 *
 * Lazy-loads chart-inner for React, uses chart-inner-dom for DOM rendering.
 */

import React from 'react';
import type { Message, ChartTemplate } from '../../core/types.js';
import type { TemplateRenderer, TemplateContext } from '../types.js';
import { defaultRegistry } from '../registry.js';
import { getString } from '../utils/strings.js';
import { renderChartDOM } from './chart-inner-dom.js';

const LazyChartInner = React.lazy(() => import('./chart-inner.js'));

/** Error boundary for chart lazy-load failures (network errors, chunk 404s) */
class ChartErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }

  override render(): React.ReactNode {
    if (this.state.hasError) {
      return React.createElement(
        'div',
        { className: 'rich-chart-error', role: 'alert' },
        getString('chart.error'),
      );
    }
    return this.props.children;
  }
}

const chartRenderer: TemplateRenderer<ChartTemplate> = {
  type: 'chart',

  extract(message: Message): ChartTemplate | undefined {
    return message.richContent?.chart;
  },

  render(data: ChartTemplate, _ctx: TemplateContext): React.ReactElement {
    return React.createElement(
      ChartErrorBoundary,
      null,
      React.createElement(
        React.Suspense,
        {
          fallback: React.createElement(
            'div',
            { className: 'rich-chart-loading', role: 'status' },
            getString('chart.loading'),
          ),
        },
        React.createElement(LazyChartInner, { data }),
      ),
    );
  },

  renderDOM(data: ChartTemplate, _ctx: TemplateContext): HTMLElement {
    return renderChartDOM(data);
  },
};

defaultRegistry.register(chartRenderer);

export { chartRenderer };
