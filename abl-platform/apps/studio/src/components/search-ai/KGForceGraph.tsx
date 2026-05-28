/**
 * KGForceGraph Component
 *
 * Interactive force-directed graph visualization for Knowledge Graph.
 * Uses react-force-graph (Canvas2D) for zoom, pan, drag, and click-to-explore.
 *
 * Node types are visually differentiated by color and size:
 *   - domain:          large, accent color (center hub)
 *   - category:        medium-large, teal
 *   - product:         medium, purple
 *   - attribute:       small, blue
 *   - entity_instance: small, green
 *
 * Edges rendered as directional arrows with type labels on hover.
 * Supports: zoom, pan, drag nodes, click to select, hover tooltips.
 *
 * Colors are read from CSS custom properties via getCSSVar() so the
 * canvas stays in sync with the design-system theme.
 */

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import type { GraphNode, GraphEdge } from '../../api/search-ai';

// ForceGraph2D uses Canvas and must be client-only (no SSR)
// Using react-force-graph-2d (not react-force-graph) to avoid AFRAME/three.js/VR/AR deps
const ForceGraph2D = dynamic(() => import('react-force-graph-2d'), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center h-full w-full bg-background">
      <div className="skeleton h-full w-full rounded-lg" />
    </div>
  ),
});

// ─── Helpers ──────────────────────────────────────────────────────────

/** Read a CSS custom property from :root at render time.
 *  Canvas2D cannot use CSS vars natively, so we bridge via JS. */
function getCSSVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

// ─── Visual Config ─────────────────────────────────────────────────────

/** Build node color map from live CSS custom properties. */
function useNodeColors(): Record<string, string> {
  return useMemo(
    () => ({
      domain: `hsl(${getCSSVar('--purple', '262.1 83.3% 57.8%')})`,
      category: `hsl(${getCSSVar('--info', '187.2 85.7% 53.3%')})`,
      product: `hsl(${getCSSVar('--purple-muted', '262.1 83.3% 40%')})`,
      attribute: `hsl(${getCSSVar('--accent', '220 5% 93%')})`,
      entity_instance: `hsl(${getCSSVar('--success', '142.1 76.2% 36.3%')})`,
    }),
    [],
  );
}

const NODE_SIZES: Record<string, number> = {
  domain: 28,
  category: 18,
  product: 12,
  attribute: 6,
  entity_instance: 5,
};

// ─── Types ─────────────────────────────────────────────────────────────

interface ForceNode {
  id: string;
  label: string;
  type: string;
  properties: Record<string, unknown>;
  x?: number;
  y?: number;
  fx?: number;
  fy?: number;
}

interface ForceLink {
  source: string;
  target: string;
  type: string;
}

interface KGForceGraphProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  onNodeClick?: (node: GraphNode) => void;
  selectedNodeId?: string | null;
  className?: string;
  height?: number;
}

// ─── Component ─────────────────────────────────────────────────────────

export function KGForceGraph({
  nodes,
  edges,
  onNodeClick,
  selectedNodeId,
  className,
  height = 600,
}: KGForceGraphProps) {
  const t = useTranslations('search_ai.kg');
  const graphRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);

  // Responsive height — clamp between 400 and 700 based on viewport
  const responsiveHeight = useMemo(() => {
    if (typeof window === 'undefined') return height;
    return Math.min(Math.max(window.innerHeight - 300, 400), 700);
  }, [height]);

  const [dimensions, setDimensions] = useState({
    width: 800,
    height: responsiveHeight,
  });

  // Theme-aware colors
  const nodeColors = useNodeColors();

  const edgeColor = useMemo(() => {
    const muted = getCSSVar('--muted', '220 5% 50%');
    return `hsla(${muted}, 0.35)`;
  }, []);

  const edgeColorHover = useMemo(() => {
    const muted = getCSSVar('--muted', '220 5% 50%');
    return `hsla(${muted}, 0.7)`;
  }, []);

  const selectedRingColor = useMemo(() => `hsl(${getCSSVar('--warning', '38 92% 50%')})`, []);

  const hoverRingColor = useMemo(() => {
    const fg = getCSSVar('--foreground', '220 5% 93%');
    return `hsla(${fg}, 0.5)`;
  }, []);

  const bgColor = useMemo(() => `hsl(${getCSSVar('--background', '220 5% 3.9%')})`, []);

  const labelBgColor = useMemo(() => {
    const bg = getCSSVar('--background', '220 5% 3.9%');
    return `hsla(${bg}, 0.75)`;
  }, []);

  const labelTextColor = useMemo(() => `hsl(${getCSSVar('--foreground', '220 5% 93%')})`, []);

  // Arrow / link accent color
  const arrowColor = useMemo(() => {
    const muted = getCSSVar('--muted', '220 5% 50%');
    return `hsla(${muted}, 0.5)`;
  }, []);

  // Measure container width
  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setDimensions({
          width: entry.contentRect.width,
          height: responsiveHeight,
        });
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [responsiveHeight]);

  // Convert our GraphNode/GraphEdge to force-graph format
  const graphData = useMemo(() => {
    const forceNodes: ForceNode[] = nodes.map((n) => ({
      id: n.id,
      label: n.label,
      type: n.type,
      properties: n.properties ?? {},
    }));

    const forceLinks: ForceLink[] = edges.map((e) => ({
      source: e.from,
      target: e.to,
      type: e.type,
    }));

    return { nodes: forceNodes, links: forceLinks };
  }, [nodes, edges]);

  // Configure forces and zoom to fit after render
  useEffect(() => {
    if (!graphRef.current) return;

    // Increase charge repulsion so nodes spread out
    const charge = graphRef.current.d3Force('charge');
    if (charge) {
      charge.strength(-200).distanceMax(300);
    }

    // Increase link distance for better spacing
    const link = graphRef.current.d3Force('link');
    if (link) {
      link.distance(60);
    }

    // Zoom to fit after layout settles
    const timer = setTimeout(() => {
      if (graphRef.current) {
        graphRef.current.zoomToFit(400, 60);
      }
    }, 800);
    return () => clearTimeout(timer);
  }, [graphData]);

  // Custom node rendering with Canvas
  const paintNode = useCallback(
    (node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const { id, label, type, x, y } = node;
      if (x === undefined || y === undefined) return;

      const size = (NODE_SIZES[type] ?? 8) / globalScale;
      const color = nodeColors[type] ?? `hsl(${getCSSVar('--muted', '220 5% 50%')})`;
      const isSelected = selectedNodeId === id;
      const isHovered = hoveredNode === id;

      // Selection ring
      if (isSelected) {
        ctx.beginPath();
        ctx.arc(x, y, size + 3 / globalScale, 0, 2 * Math.PI);
        ctx.strokeStyle = selectedRingColor;
        ctx.lineWidth = 2.5 / globalScale;
        ctx.stroke();
      }

      // Hover ring
      if (isHovered && !isSelected) {
        ctx.beginPath();
        ctx.arc(x, y, size + 2 / globalScale, 0, 2 * Math.PI);
        ctx.strokeStyle = hoverRingColor;
        ctx.lineWidth = 1.5 / globalScale;
        ctx.stroke();
      }

      // Node circle
      ctx.beginPath();
      ctx.arc(x, y, size, 0, 2 * Math.PI);
      ctx.fillStyle = color;
      ctx.fill();

      // Inner highlight for depth effect
      ctx.beginPath();
      ctx.arc(x - size * 0.25, y - size * 0.25, size * 0.35, 0, 2 * Math.PI);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
      ctx.fill();

      // Label — show for domain/category always, products at medium zoom, others at high zoom
      const showLabel =
        type === 'domain' ||
        type === 'category' ||
        (type === 'product' && globalScale >= 0.8) ||
        ((type === 'attribute' || type === 'entity_instance') && globalScale >= 2) ||
        isSelected ||
        isHovered;

      if (showLabel) {
        const fontSize = Math.max(
          10 / globalScale,
          type === 'domain'
            ? 14 / globalScale
            : type === 'category'
              ? 12 / globalScale
              : 10 / globalScale,
        );
        ctx.font = `${type === 'domain' || type === 'category' ? 'bold ' : ''}${fontSize}px Inter, system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';

        const text = label.length > 24 && globalScale < 1.5 ? label.slice(0, 22) + '…' : label;
        const textY = y + size + 3 / globalScale;

        // Text background for readability
        const textMetrics = ctx.measureText(text);
        const bgPadding = 2 / globalScale;
        ctx.fillStyle = labelBgColor;
        ctx.fillRect(
          x - textMetrics.width / 2 - bgPadding,
          textY - bgPadding,
          textMetrics.width + bgPadding * 2,
          fontSize + bgPadding * 2,
        );

        ctx.fillStyle = labelTextColor;
        ctx.fillText(text, x, textY);
      }
    },
    [
      selectedNodeId,
      hoveredNode,
      nodeColors,
      selectedRingColor,
      hoverRingColor,
      labelBgColor,
      labelTextColor,
    ],
  );

  // Hit area matches visual size
  const paintNodeArea = useCallback(
    (node: any, color: string, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const { type, x, y } = node;
      if (x === undefined || y === undefined) return;
      const size = (NODE_SIZES[type] ?? 8) / globalScale;
      ctx.beginPath();
      ctx.arc(x, y, size + 4 / globalScale, 0, 2 * Math.PI);
      ctx.fillStyle = color;
      ctx.fill();
    },
    [],
  );

  const handleNodeClick = useCallback(
    (node: any) => {
      if (!onNodeClick) return;
      // Map back to GraphNode interface
      const graphNode: GraphNode = {
        id: node.id,
        label: node.label,
        type: node.type,
        properties: node.properties,
      };
      onNodeClick(graphNode);
    },
    [onNodeClick],
  );

  const handleNodeHover = useCallback((node: any) => {
    setHoveredNode(node?.id ?? null);
  }, []);

  return (
    <div
      ref={containerRef}
      className={className}
      style={{
        height: responsiveHeight,
        position: 'relative',
        borderRadius: '0.5rem',
        overflow: 'hidden',
      }}
    >
      {/* Legend */}
      <div className="absolute top-3 left-3 z-10 flex flex-col gap-1 p-2 px-3 rounded-lg bg-background-elevated/80 backdrop-blur-sm text-xs text-foreground">
        {[
          { type: 'domain', label: t('graph_legend_domain') },
          { type: 'category', label: t('graph_legend_category') },
          { type: 'product', label: t('graph_legend_product') },
          { type: 'attribute', label: t('graph_legend_attribute') },
          { type: 'entity_instance', label: t('graph_legend_entity') },
        ].map(({ type, label }) => (
          <div key={type} className="flex items-center gap-1.5">
            <span
              className="w-2 h-2 rounded-full inline-block"
              style={{ background: nodeColors[type] }}
            />
            <span>{label}</span>
          </div>
        ))}
      </div>

      {/* Zoom controls */}
      <div className="absolute bottom-3 right-3 z-10 flex flex-col gap-1">
        <button
          onClick={() => graphRef.current?.zoom(graphRef.current.zoom() * 1.5, 300)}
          className="w-8 h-8 rounded-md bg-background-elevated/80 text-foreground border border-default/30 flex items-center justify-center text-base hover:bg-background-muted transition-default"
          title={t('graph_zoom_in')}
        >
          +
        </button>
        <button
          onClick={() => graphRef.current?.zoom(graphRef.current.zoom() / 1.5, 300)}
          className="w-8 h-8 rounded-md bg-background-elevated/80 text-foreground border border-default/30 flex items-center justify-center text-base hover:bg-background-muted transition-default"
          title={t('graph_zoom_out')}
        >
          −
        </button>
        <button
          onClick={() => graphRef.current?.zoomToFit(400, 60)}
          className="w-8 h-8 rounded-md bg-background-elevated/80 text-foreground border border-default/30 flex items-center justify-center text-[11px] hover:bg-background-muted transition-default"
          title={t('graph_fit')}
        >
          ⊡
        </button>
      </div>

      <ForceGraph2D
        ref={graphRef}
        graphData={graphData}
        width={dimensions.width}
        height={dimensions.height}
        backgroundColor={bgColor}
        // Node rendering
        nodeCanvasObject={paintNode}
        nodeCanvasObjectMode={() => 'replace'}
        nodePointerAreaPaint={paintNodeArea}
        // Link styling
        linkColor={() => edgeColor}
        linkWidth={1.5}
        linkDirectionalArrowLength={4}
        linkDirectionalArrowRelPos={1}
        linkDirectionalArrowColor={() => arrowColor}
        linkCurvature={0.15}
        // Force layout — standard force-directed with tuned repulsion
        d3AlphaDecay={0.02}
        d3VelocityDecay={0.3}
        warmupTicks={50}
        cooldownTicks={200}
        // Interaction
        onNodeClick={handleNodeClick}
        onNodeHover={handleNodeHover}
        enableNodeDrag={true}
        // Zoom only on Ctrl/Cmd+scroll — lets normal page scroll work
        enableZoomInteraction={(event: any) =>
          event?.ctrlKey || event?.metaKey || event?.type === 'dblclick'
        }
        enablePanInteraction={true}
      />

      {/* Zoom hint overlay */}
      <div className="absolute bottom-3 left-3 z-10 py-1 px-2 rounded-md bg-background-elevated/70 text-[10px] text-muted">
        {t('graph_zoom_hint')}
      </div>
    </div>
  );
}
