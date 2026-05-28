import { EDGE_COLORS, EDGE_COLORS_HOVER } from './RelationshipEdge';

export function EdgeMarkerDefs() {
  return (
    <svg style={{ position: 'absolute', width: 0, height: 0 }}>
      <defs>
        {/* Handoff: filled arrow — subtle */}
        <marker
          id="agent-arrow-handoff"
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerWidth={10}
          markerHeight={10}
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill={EDGE_COLORS.handoff} opacity={0.5} />
        </marker>
        {/* Delegate: open arrow — subtle */}
        <marker
          id="agent-arrow-delegate"
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerWidth={10}
          markerHeight={10}
          orient="auto-start-reverse"
        >
          <path
            d="M 1 1 L 9 5 L 1 9"
            fill="none"
            stroke={EDGE_COLORS.delegate}
            strokeWidth={1.5}
            opacity={0.5}
          />
        </marker>
        {/* Escalate: diamond — subtle */}
        <marker
          id="agent-arrow-escalate"
          viewBox="0 0 12 12"
          refX="10"
          refY="6"
          markerWidth={10}
          markerHeight={10}
          orient="auto-start-reverse"
        >
          <path d="M 0 6 L 6 0 L 12 6 L 6 12 z" fill={EDGE_COLORS.escalate} opacity={0.5} />
        </marker>
        {/* Handoff: filled arrow — active */}
        <marker
          id="agent-arrow-handoff-active"
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerWidth={10}
          markerHeight={10}
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill={EDGE_COLORS_HOVER.handoff} />
        </marker>
        {/* Delegate: open arrow — active */}
        <marker
          id="agent-arrow-delegate-active"
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerWidth={10}
          markerHeight={10}
          orient="auto-start-reverse"
        >
          <path
            d="M 1 1 L 9 5 L 1 9"
            fill="none"
            stroke={EDGE_COLORS_HOVER.delegate}
            strokeWidth={1.5}
          />
        </marker>
        {/* Escalate: diamond — active */}
        <marker
          id="agent-arrow-escalate-active"
          viewBox="0 0 12 12"
          refX="10"
          refY="6"
          markerWidth={10}
          markerHeight={10}
          orient="auto-start-reverse"
        >
          <path d="M 0 6 L 6 0 L 12 6 L 6 12 z" fill={EDGE_COLORS_HOVER.escalate} />
        </marker>
      </defs>
    </svg>
  );
}
