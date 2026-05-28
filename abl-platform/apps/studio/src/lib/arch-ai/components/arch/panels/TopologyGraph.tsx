'use client';

import { useId, useMemo, useState, useCallback, useRef } from 'react';

interface TopologyAgent {
  name: string;
  role: string;
  executionMode: string;
  suggestedConstructs?: string[];
}

interface TopologyEdge {
  from: string;
  to: string;
  type: string;
  experienceMode?: string;
  condition: string;
  returnsControl?: boolean;
}

interface TopologyGraphProps {
  agents: TopologyAgent[];
  edges: TopologyEdge[];
  entryPoint: string;
  pattern?: string;
  reasoning?: string;
  onAgentClick?: (agentName: string) => void;
  /** Build status per agent name — drives node styling during BUILD */
  buildStatus?: Record<string, string>;
}

interface NodePosition {
  x: number;
  y: number;
  agent: TopologyAgent;
}

const NODE_W = 160;
const NODE_H = 64;
const H_GAP = 40;
const V_GAP = 80;

/** Map edge types to HSL CSS variable fills for edge labels */
const EDGE_TYPE_FILLS: Record<string, string> = {
  routing: 'hsl(var(--info))',
  handoff: 'hsl(var(--foreground))',
  delegate: 'hsl(var(--accent))',
  escalation: 'hsl(var(--warning))',
  pipeline_next: 'hsl(var(--success))',
};

const EDGE_EXPERIENCE_LABELS: Record<string, string> = {
  shared_voice_handoff: 'shared voice',
  visible_handoff: 'visible',
  silent_delegate: 'silent',
  human_escalation: 'human',
};

function formatEdgeLabel(edge: TopologyEdge): string {
  const experience = edge.experienceMode ? EDGE_EXPERIENCE_LABELS[edge.experienceMode] : undefined;
  return experience ? `${edge.type}: ${experience}` : edge.type;
}

/**
 * TopologyGraph — SVG-based node-edge graph for agent topology.
 * Entry agent at top center, leaf agents below in a row.
 * Edges drawn as curved paths with arrow markers.
 */
export function TopologyGraph({
  agents,
  edges,
  entryPoint,
  pattern,
  reasoning,
  onAgentClick,
  buildStatus,
}: TopologyGraphProps) {
  const svgId = useId().replace(/:/g, '');
  const gridId = `topo-grid-${svgId}`;
  const arrowFwdId = `arrow-fwd-${svgId}`;
  const arrowRetId = `arrow-ret-${svgId}`;

  const layout = useMemo(() => {
    if (agents.length === 0) return { nodes: [], width: 0, height: 0 };

    const entry = agents.find((a) => a.name === entryPoint) ?? agents[0];
    const others = agents.filter((a) => a.name !== entry.name);

    // Layout: entry at top center, others in a row below
    const rowWidth = others.length * NODE_W + (others.length - 1) * H_GAP;
    const totalWidth = Math.max(rowWidth, NODE_W) + 80;
    const entryX = totalWidth / 2 - NODE_W / 2;
    const entryY = 30;

    const nodes: NodePosition[] = [{ x: entryX, y: entryY, agent: entry }];

    const startX = (totalWidth - rowWidth) / 2;
    others.forEach((agent, i) => {
      nodes.push({
        x: startX + i * (NODE_W + H_GAP),
        y: entryY + NODE_H + V_GAP,
        agent,
      });
    });

    const height = entryY + NODE_H + V_GAP + NODE_H + 40;
    return { nodes, width: totalWidth, height };
  }, [agents, entryPoint]);

  // Pan & zoom hooks must run before the empty-state return. Topology data can
  // arrive after the graph first renders empty, and React requires a stable hook order.
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const isPanning = useRef(false);
  const panStart = useRef({ x: 0, y: 0 });
  const svgRef = useRef<SVGSVGElement>(null);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    setZoom((z) => Math.max(0.3, Math.min(3, z + delta)));
  }, []);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      isPanning.current = true;
      panStart.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
      (e.target as Element).setPointerCapture(e.pointerId);
    },
    [pan],
  );

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!isPanning.current) return;
    setPan({
      x: e.clientX - panStart.current.x,
      y: e.clientY - panStart.current.y,
    });
  }, []);

  const handlePointerUp = useCallback(() => {
    isPanning.current = false;
  }, []);

  const resetView = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  if (agents.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6">
        <svg
          width="32"
          height="32"
          viewBox="0 0 18 18"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          className="text-foreground/10"
          aria-hidden="true"
        >
          <path
            d="M9 2L16 16H2L9 2Z"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinejoin="round"
          />
          <path d="M6 11.5H12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        <div className="text-center">
          <p className="text-xs font-medium text-foreground-muted">No topology yet</p>
          <p className="mt-0.5 text-[11px] text-foreground-subtle">Agent graph will render here</p>
        </div>
      </div>
    );
  }

  const { nodes, width, height } = layout;
  const nodeMap = new Map(nodes.map((n) => [n.agent.name, n]));

  // Compute viewBox based on pan/zoom
  const vbW = width / zoom;
  const vbH = height / zoom;
  const vbX = -pan.x / zoom;
  const vbY = -pan.y / zoom;

  return (
    <div className="relative h-full w-full bg-background/50 rounded-lg border border-border/50">
      {pattern && (
        <div className="px-3 pt-2 pb-1 text-xs text-foreground-muted">
          Pattern: <span className="font-medium text-foreground">{pattern.replace(/_/g, ' ')}</span>
          {reasoning && <span className="ml-2 text-foreground-muted">&mdash; {reasoning}</span>}
        </div>
      )}

      {/* Zoom controls */}
      <div className="absolute top-2 right-2 z-10 flex items-center gap-1 rounded-md border border-border/50 bg-background/80 backdrop-blur-sm px-1 py-0.5">
        <button
          type="button"
          onClick={() => setZoom((z) => Math.min(3, z + 0.2))}
          className="px-1.5 py-0.5 text-xs text-foreground-muted hover:text-foreground"
          aria-label="Zoom in"
        >
          +
        </button>
        <span className="text-[10px] text-foreground-muted min-w-[32px] text-center">
          {Math.round(zoom * 100)}%
        </span>
        <button
          type="button"
          onClick={() => setZoom((z) => Math.max(0.3, z - 0.2))}
          className="px-1.5 py-0.5 text-xs text-foreground-muted hover:text-foreground"
          aria-label="Zoom out"
        >
          &minus;
        </button>
        <button
          type="button"
          onClick={resetView}
          className="px-1.5 py-0.5 text-[10px] text-foreground-muted hover:text-foreground border-l border-border/50"
          aria-label="Reset view"
        >
          Fit
        </button>
      </div>

      <svg
        ref={svgRef}
        width="100%"
        height="100%"
        viewBox={`${vbX} ${vbY} ${vbW} ${vbH}`}
        xmlns="http://www.w3.org/2000/svg"
        className="min-h-[250px] cursor-grab active:cursor-grabbing"
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        <defs>
          {/* Grid pattern */}
          <pattern id={gridId} width="24" height="24" patternUnits="userSpaceOnUse">
            <path
              d="M24 0L0 0 0 24"
              fill="none"
              stroke="hsl(var(--border) / 0.15)"
              strokeWidth="0.5"
            />
          </pattern>
          {/* Forward arrow (purple) */}
          <marker id={arrowFwdId} markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
            <path d="M0,0 L8,3 L0,6" fill="none" stroke="hsl(var(--purple))" strokeWidth="1.2" />
          </marker>
          {/* Return arrow (muted) */}
          <marker id={arrowRetId} markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
            <path
              d="M0,0 L8,3 L0,6"
              fill="none"
              stroke="hsl(var(--foreground-muted))"
              strokeWidth="1"
            />
          </marker>
        </defs>

        <rect width={width} height={height} fill={`url(#${gridId})`} />

        {/* Edges */}
        {edges.map((edge, i) => {
          const from = nodeMap.get(edge.from);
          const to = nodeMap.get(edge.to);
          if (!from || !to) return null;

          const isForward = from.y < to.y;
          const fromCx = from.x + NODE_W / 2;
          const fromCy = from.y + NODE_H;
          const toCx = to.x + NODE_W / 2;
          const toCy = to.y;
          const edgeLabel = formatEdgeLabel(edge);

          if (isForward) {
            // Forward edge: from bottom of source to top of target
            const midY = (fromCy + toCy) / 2;
            return (
              <g key={`edge-${i}`}>
                <path
                  d={`M${fromCx},${fromCy} C${fromCx},${midY} ${toCx},${midY} ${toCx},${toCy}`}
                  fill="none"
                  stroke="hsl(var(--purple))"
                  strokeWidth="1.5"
                  strokeDasharray="5,3"
                  markerEnd={`url(#${arrowFwdId})`}
                  opacity="0.6"
                />
                <text
                  x={(fromCx + toCx) / 2}
                  y={midY - 4}
                  fontSize="8"
                  fill={EDGE_TYPE_FILLS[edge.type] ?? 'hsl(var(--foreground-muted))'}
                  textAnchor="middle"
                  fontFamily="'Geist Mono', 'ui-monospace', monospace"
                >
                  {edgeLabel}
                </text>
              </g>
            );
          } else {
            // Return edge: curved back up
            const offset = i % 2 === 0 ? -30 : 30;
            const fromBot = from.y + NODE_H / 2;
            const toTop = to.y + NODE_H / 2;
            return (
              <g key={`edge-${i}`}>
                <path
                  d={`M${from.x + (offset > 0 ? NODE_W : 0)},${fromBot} C${from.x + offset},${fromBot - 40} ${to.x + NODE_W + offset},${toTop + 40} ${to.x + NODE_W / 2 + (offset > 0 ? 20 : -20)},${toTop}`}
                  fill="none"
                  stroke="hsl(var(--foreground-muted))"
                  strokeWidth="1"
                  strokeDasharray="3,3"
                  markerEnd={`url(#${arrowRetId})`}
                  opacity="0.35"
                />
                <text
                  x={from.x + offset}
                  y={fromBot - 20}
                  fontSize="7"
                  fill={EDGE_TYPE_FILLS[edge.type] ?? 'hsl(var(--foreground-subtle))'}
                  fontFamily="'Geist Mono', 'ui-monospace', monospace"
                  fontStyle="italic"
                >
                  {edgeLabel}
                </text>
              </g>
            );
          }
        })}

        {/* Nodes */}
        {nodes.map((node) => {
          const isEntry = node.agent.name === entryPoint;
          const bs = buildStatus?.[node.agent.name];

          // Build-status-driven styles
          const nodeStroke =
            bs === 'compiled'
              ? 'hsl(var(--success))'
              : bs === 'warning'
                ? 'hsl(var(--warning))'
                : bs === 'error'
                  ? 'hsl(var(--error))'
                  : bs === 'generating' || bs === 'generated'
                    ? 'hsl(var(--accent))'
                    : bs === 'pending'
                      ? 'hsl(var(--border) / 0.4)'
                      : isEntry
                        ? 'hsl(var(--purple) / 0.4)'
                        : 'hsl(var(--border))';
          const nodeStrokeWidth = bs ? 2 : isEntry ? 1.5 : 1;
          const nodeOpacity = bs === 'pending' ? 0.5 : 1;
          const isAnimating = bs === 'generating' || bs === 'generated';

          return (
            <g
              key={node.agent.name}
              transform={`translate(${node.x}, ${node.y})`}
              opacity={nodeOpacity}
              className={isAnimating ? 'animate-pulse-soft' : undefined}
              onClick={onAgentClick ? () => onAgentClick(node.agent.name) : undefined}
              style={{ cursor: onAgentClick ? 'pointer' : 'default' }}
            >
              <rect
                width={NODE_W}
                height={NODE_H}
                rx="10"
                fill="hsl(var(--background-elevated))"
                stroke={nodeStroke}
                strokeWidth={nodeStrokeWidth}
                className={onAgentClick ? 'transition-opacity hover:opacity-80' : ''}
              />
              {isEntry && (
                <>
                  <circle cx="13" cy="13" r="3.5" fill="hsl(var(--purple))" />
                  <text
                    x="22"
                    y="16"
                    fontSize="8"
                    fill="hsl(var(--purple))"
                    fontWeight="600"
                    fontFamily="'Geist Mono', 'ui-monospace', monospace"
                  >
                    entry
                  </text>
                </>
              )}
              <text
                x={NODE_W / 2}
                y={isEntry ? 34 : 26}
                fontSize="12"
                fill="hsl(var(--foreground))"
                fontWeight="600"
                fontFamily="'Geist Mono', 'ui-monospace', monospace"
                textAnchor="middle"
              >
                {node.agent.name}
              </text>
              <rect
                x="10"
                y={isEntry ? 42 : 34}
                width="50"
                height="16"
                rx="4"
                fill={isEntry ? 'hsl(var(--purple) / 0.1)' : 'hsl(var(--foreground) / 0.04)'}
              />
              <text
                x="35"
                y={isEntry ? 53 : 45}
                fontSize="8"
                fill={isEntry ? 'hsl(var(--purple))' : 'hsl(var(--foreground-muted))'}
                fontFamily="'Geist Mono', 'ui-monospace', monospace"
                textAnchor="middle"
              >
                {node.agent.executionMode}
              </text>
              <text
                x="70"
                y={isEntry ? 53 : 45}
                fontSize="8"
                fill="hsl(var(--foreground-muted))"
                fontFamily="'Geist Mono', 'ui-monospace', monospace"
              >
                {node.agent.role.slice(0, 20)}
              </text>
              {(node.agent.suggestedConstructs?.length ?? 0) > 0 && (
                <text
                  x={NODE_W - 10}
                  y={isEntry ? 16 : 16}
                  fontSize="9"
                  fill="hsl(var(--foreground-muted))"
                  fontFamily="'Geist Mono', 'ui-monospace', monospace"
                  textAnchor="end"
                >
                  {node.agent.suggestedConstructs?.length ?? 0} constructs
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
