/**
 * Chart Inner Component (React)
 *
 * Renders SVG bar, line, and pie charts.
 * Loaded lazily by chart.ts via React.lazy().
 */

import React from 'react';
import type { ChartTemplate, ChartDataPoint } from '../../core/types.js';
import { DEFAULT_COLORS } from '../utils/chart-colors.js';
import { getString } from '../utils/strings.js';

function getColor(point: ChartDataPoint, index: number): string {
  return point.color ?? DEFAULT_COLORS[index % DEFAULT_COLORS.length];
}

// ---------------------------------------------------------------------------
// Bar chart
// ---------------------------------------------------------------------------

function BarChart({ data }: { data: ChartDataPoint[] }): React.ReactElement {
  const maxVal = Math.max(...data.map((d) => d.value), 1);
  const barWidth = Math.max(20, Math.floor(260 / data.length) - 10);
  const chartHeight = 160;
  const labelY = 180;

  return (
    <svg
      viewBox="0 0 300 200"
      className="rich-chart-svg"
      role="img"
      aria-label={getString('chart.bar')}
    >
      {data.map((point, i) => {
        const barHeight = (point.value / maxVal) * chartHeight;
        const x = 20 + i * (barWidth + 10);
        const y = chartHeight - barHeight;
        return (
          <g key={i}>
            <rect x={x} y={y} width={barWidth} height={barHeight} fill={getColor(point, i)} rx={2}>
              <title>{`${point.label}: ${point.value}`}</title>
            </rect>
            <text
              x={x + barWidth / 2}
              y={labelY}
              textAnchor="middle"
              fontSize="10"
              fill="currentColor"
            >
              {point.label.length > 8 ? point.label.slice(0, 7) + '\u2026' : point.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Line chart
// ---------------------------------------------------------------------------

function LineChart({ data }: { data: ChartDataPoint[] }): React.ReactElement {
  const maxVal = Math.max(...data.map((d) => d.value), 1);
  const chartHeight = 160;
  const chartWidth = 260;

  const points = data.map((point, i) => {
    const x = 20 + (i / Math.max(data.length - 1, 1)) * chartWidth;
    const y = chartHeight - (point.value / maxVal) * chartHeight;
    return { x, y, point };
  });

  const polylinePoints = points.map((p) => `${p.x},${p.y}`).join(' ');
  const color = data[0]?.color ?? DEFAULT_COLORS[0];

  return (
    <svg
      viewBox="0 0 300 200"
      className="rich-chart-svg"
      role="img"
      aria-label={getString('chart.line')}
    >
      <polyline
        points={polylinePoints}
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinejoin="round"
      />
      {points.map((p, i) => (
        <g key={i}>
          <circle cx={p.x} cy={p.y} r="3" fill={color}>
            <title>{`${p.point.label}: ${p.point.value}`}</title>
          </circle>
          <text x={p.x} y={180} textAnchor="middle" fontSize="10" fill="currentColor">
            {p.point.label.length > 8 ? p.point.label.slice(0, 7) + '\u2026' : p.point.label}
          </text>
        </g>
      ))}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Pie chart
// ---------------------------------------------------------------------------

function PieChart({ data }: { data: ChartDataPoint[] }): React.ReactElement {
  const total = data.reduce((sum, d) => sum + d.value, 0) || 1;
  const cx = 100;
  const cy = 100;
  const r = 80;

  let startAngle = -Math.PI / 2;

  const slices = data.map((point, i) => {
    const sliceAngle = (point.value / total) * 2 * Math.PI;
    const endAngle = startAngle + sliceAngle;
    const largeArc = sliceAngle > Math.PI ? 1 : 0;

    const x1 = cx + r * Math.cos(startAngle);
    const y1 = cy + r * Math.sin(startAngle);
    const x2 = cx + r * Math.cos(endAngle);
    const y2 = cy + r * Math.sin(endAngle);

    const d = `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} Z`;

    const element = (
      <path key={i} d={d} fill={getColor(point, i)}>
        <title>{`${point.label}: ${point.value}`}</title>
      </path>
    );

    startAngle = endAngle;
    return element;
  });

  return (
    <svg
      viewBox="0 0 200 200"
      className="rich-chart-svg"
      role="img"
      aria-label={getString('chart.pie')}
    >
      {slices}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export interface ChartInnerProps {
  data: ChartTemplate;
}

/** Maximum data points rendered to prevent DOM performance degradation */
const MAX_DATA_POINTS = 100;

function ChartInner({ data }: ChartInnerProps): React.ReactElement {
  const cappedData =
    data.data.length > MAX_DATA_POINTS ? data.data.slice(0, MAX_DATA_POINTS) : data.data;
  const chartContent =
    data.type === 'bar' ? (
      <BarChart data={cappedData} />
    ) : data.type === 'line' ? (
      <LineChart data={cappedData} />
    ) : (
      <PieChart data={cappedData} />
    );

  return (
    <div className="rich-chart" role="figure" aria-label={data.title ?? getString('chart.label')}>
      {data.title && <div className="rich-chart-title">{data.title}</div>}
      {chartContent}
    </div>
  );
}

export default ChartInner;
