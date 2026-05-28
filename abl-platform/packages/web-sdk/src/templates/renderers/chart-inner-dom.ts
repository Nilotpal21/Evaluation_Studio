/**
 * Chart Inner DOM Renderer
 *
 * Generates inline SVG charts using DOM APIs (document.createElementNS).
 * Used by chart.ts renderDOM() for non-React consumers.
 */

import type { ChartTemplate, ChartDataPoint } from '../../core/types.js';
import { DEFAULT_COLORS } from '../utils/chart-colors.js';
import { getString } from '../utils/strings.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

function getColor(point: ChartDataPoint, index: number): string {
  return point.color ?? DEFAULT_COLORS[index % DEFAULT_COLORS.length];
}

function truncateLabel(label: string, maxLen = 8): string {
  return label.length > maxLen ? label.slice(0, maxLen - 1) + '\u2026' : label;
}

function createSvg(viewBox: string, ariaLabel: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', viewBox);
  svg.setAttribute('class', 'rich-chart-svg');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', ariaLabel);
  return svg;
}

function createTitle(parent: SVGElement, text: string): void {
  const title = document.createElementNS(SVG_NS, 'title');
  title.textContent = text;
  parent.appendChild(title);
}

// ---------------------------------------------------------------------------
// Bar chart
// ---------------------------------------------------------------------------

function renderBarChart(data: ChartDataPoint[]): SVGSVGElement {
  const svg = createSvg('0 0 300 200', getString('chart.bar'));
  const maxVal = Math.max(...data.map((d) => d.value), 1);
  const barWidth = Math.max(20, Math.floor(260 / data.length) - 10);
  const chartHeight = 160;

  data.forEach((point, i) => {
    const barHeight = (point.value / maxVal) * chartHeight;
    const x = 20 + i * (barWidth + 10);
    const y = chartHeight - barHeight;

    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', String(x));
    rect.setAttribute('y', String(y));
    rect.setAttribute('width', String(barWidth));
    rect.setAttribute('height', String(barHeight));
    rect.setAttribute('fill', getColor(point, i));
    rect.setAttribute('rx', '2');
    createTitle(rect, `${point.label}: ${point.value}`);
    svg.appendChild(rect);

    const text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('x', String(x + barWidth / 2));
    text.setAttribute('y', '180');
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('font-size', '10');
    text.setAttribute('fill', 'currentColor');
    text.textContent = truncateLabel(point.label);
    svg.appendChild(text);
  });

  return svg;
}

// ---------------------------------------------------------------------------
// Line chart
// ---------------------------------------------------------------------------

function renderLineChart(data: ChartDataPoint[]): SVGSVGElement {
  const svg = createSvg('0 0 300 200', getString('chart.line'));
  const maxVal = Math.max(...data.map((d) => d.value), 1);
  const chartHeight = 160;
  const chartWidth = 260;
  const color = data[0]?.color ?? DEFAULT_COLORS[0];

  const coords = data.map((point, i) => ({
    x: 20 + (i / Math.max(data.length - 1, 1)) * chartWidth,
    y: chartHeight - (point.value / maxVal) * chartHeight,
    point,
  }));

  // Polyline
  const polyline = document.createElementNS(SVG_NS, 'polyline');
  polyline.setAttribute('points', coords.map((c) => `${c.x},${c.y}`).join(' '));
  polyline.setAttribute('fill', 'none');
  polyline.setAttribute('stroke', color);
  polyline.setAttribute('stroke-width', '2');
  polyline.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(polyline);

  // Points + labels
  coords.forEach((c, i) => {
    const circle = document.createElementNS(SVG_NS, 'circle');
    circle.setAttribute('cx', String(c.x));
    circle.setAttribute('cy', String(c.y));
    circle.setAttribute('r', '3');
    circle.setAttribute('fill', color);
    createTitle(circle, `${c.point.label}: ${c.point.value}`);
    svg.appendChild(circle);

    const text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('x', String(c.x));
    text.setAttribute('y', '180');
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('font-size', '10');
    text.setAttribute('fill', 'currentColor');
    text.textContent = truncateLabel(c.point.label);
    svg.appendChild(text);
  });

  return svg;
}

// ---------------------------------------------------------------------------
// Pie chart
// ---------------------------------------------------------------------------

function renderPieChart(data: ChartDataPoint[]): SVGSVGElement {
  const svg = createSvg('0 0 200 200', getString('chart.pie'));
  const total = data.reduce((sum, d) => sum + d.value, 0) || 1;
  const cx = 100;
  const cy = 100;
  const r = 80;

  let startAngle = -Math.PI / 2;

  data.forEach((point, i) => {
    const sliceAngle = (point.value / total) * 2 * Math.PI;
    const endAngle = startAngle + sliceAngle;
    const largeArc = sliceAngle > Math.PI ? 1 : 0;

    const x1 = cx + r * Math.cos(startAngle);
    const y1 = cy + r * Math.sin(startAngle);
    const x2 = cx + r * Math.cos(endAngle);
    const y2 = cy + r * Math.sin(endAngle);

    const d = `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} Z`;

    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', getColor(point, i));
    createTitle(path, `${point.label}: ${point.value}`);
    svg.appendChild(path);

    startAngle = endAngle;
  });

  return svg;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Maximum data points rendered to prevent DOM performance degradation */
const MAX_DATA_POINTS = 100;

export function renderChartDOM(data: ChartTemplate): HTMLElement {
  const container = document.createElement('div');
  container.className = 'rich-chart';
  container.setAttribute('role', 'figure');
  container.setAttribute('aria-label', data.title ?? getString('chart.label'));

  if (data.title) {
    const titleEl = document.createElement('div');
    titleEl.className = 'rich-chart-title';
    titleEl.textContent = data.title;
    container.appendChild(titleEl);
  }

  const cappedData =
    data.data.length > MAX_DATA_POINTS ? data.data.slice(0, MAX_DATA_POINTS) : data.data;
  let svg: SVGSVGElement;
  switch (data.type) {
    case 'bar':
      svg = renderBarChart(cappedData);
      break;
    case 'line':
      svg = renderLineChart(cappedData);
      break;
    case 'pie':
      svg = renderPieChart(cappedData);
      break;
    default:
      svg = renderBarChart(cappedData);
  }

  container.appendChild(svg);
  return container;
}
