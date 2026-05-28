'use client';

import { memo, useState, useCallback, useRef, useEffect } from 'react';
import { Pencil, ArrowLeftRight, Trash2 } from 'lucide-react';
import { EDGE_COLORS, EDGE_LABELS, type RelationshipType } from './RelationshipEdge';

interface EdgePopoverProps {
  source: string;
  target: string;
  relationshipType: RelationshipType;
  condition?: string;
  labelX: number;
  labelY: number;
  onEdit: () => void;
  onChangeType: (newType: RelationshipType) => void;
  onDelete: () => void;
}

/** Stroke dash patterns matching the edge rendering in RelationshipEdge. */
const DASH_PATTERNS: Record<RelationshipType, string | undefined> = {
  handoff: undefined,
  delegate: '6 4',
  escalate: '2 3',
};

/** All relationship types that can be switched between. */
const ALL_TYPES: RelationshipType[] = ['handoff', 'delegate', 'escalate'];

export const EdgePopover = memo(function EdgePopover({
  source,
  target,
  relationshipType,
  condition,
  labelX,
  labelY,
  onEdit,
  onChangeType,
  onDelete,
}: EdgePopoverProps) {
  const [showTypeDropdown, setShowTypeDropdown] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const typeColor = EDGE_COLORS[relationshipType];
  const typeLabel = EDGE_LABELS[relationshipType];
  const dashPattern = DASH_PATTERNS[relationshipType];
  const otherTypes = ALL_TYPES.filter((t) => t !== relationshipType && t !== 'escalate');

  const toggleDropdown = useCallback(() => {
    setShowTypeDropdown((prev) => !prev);
  }, []);

  const handleChangeType = useCallback(
    (newType: RelationshipType) => {
      setShowTypeDropdown(false);
      onChangeType(newType);
    },
    [onChangeType],
  );

  // Close dropdown on outside click
  useEffect(() => {
    if (!showTypeDropdown) return;

    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowTypeDropdown(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showTypeDropdown]);

  return (
    <div
      className="nodrag nopan pointer-events-auto"
      style={{
        position: 'absolute',
        transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
        zIndex: 1000,
      }}
    >
      <div className="w-[260px] rounded-lg border border-default bg-background-elevated shadow-xl">
        {/* Header row */}
        <div className="flex items-center justify-between px-3 pt-2.5 pb-1">
          <div className="flex items-center gap-2">
            {/* Line indicator SVG */}
            <svg width="20" height="10" className="shrink-0">
              <line
                x1="0"
                y1="5"
                x2="20"
                y2="5"
                stroke={typeColor}
                strokeWidth="2"
                strokeDasharray={dashPattern}
              />
            </svg>
            <span
              className="text-xs font-semibold uppercase tracking-wider"
              style={{ color: typeColor }}
            >
              {typeLabel}
            </span>
          </div>
          <span className="text-xs text-foreground-muted truncate max-w-[120px]">
            {source} → {target}
          </span>
        </div>

        {/* Condition row */}
        <div className="px-3 pb-2.5">
          {condition ? (
            <p className="text-xs text-foreground">
              <span className="text-foreground-muted">When: </span>
              {condition}
            </p>
          ) : (
            <p className="text-xs text-foreground-muted">No condition set</p>
          )}
        </div>

        {/* Action buttons row */}
        <div className="flex items-center gap-1 border-t border-default px-2 py-1.5">
          {/* Edit button */}
          <button
            onClick={onEdit}
            className="flex items-center gap-1.5 p-1.5 rounded-md transition-default text-foreground-muted hover:text-foreground hover:bg-background-muted"
            title="Edit relationship"
          >
            <Pencil size={12} />
            <span className="text-xs">Edit</span>
          </button>

          {/* Change Type button with dropdown */}
          <div className="relative" ref={dropdownRef}>
            <button
              onClick={toggleDropdown}
              className="flex items-center gap-1.5 p-1.5 rounded-md transition-default text-foreground-muted hover:text-foreground hover:bg-background-muted"
              title="Change relationship type"
            >
              <ArrowLeftRight size={12} />
              <span className="text-xs">Change Type</span>
            </button>

            {showTypeDropdown && (
              <div className="absolute top-full left-0 mt-1 min-w-[160px] rounded-lg border border-default bg-background-elevated shadow-xl z-10">
                {otherTypes.map((otherType) => (
                  <button
                    key={otherType}
                    onClick={() => handleChangeType(otherType)}
                    className="flex w-full items-center gap-2 px-3 py-2 text-xs text-foreground-muted transition-default hover:text-foreground hover:bg-background-muted first:rounded-t-lg last:rounded-b-lg"
                  >
                    <svg width="16" height="8" className="shrink-0">
                      <line
                        x1="0"
                        y1="4"
                        x2="16"
                        y2="4"
                        stroke={EDGE_COLORS[otherType]}
                        strokeWidth="2"
                        strokeDasharray={DASH_PATTERNS[otherType]}
                      />
                    </svg>
                    <span>Switch to {EDGE_LABELS[otherType]}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Delete button — pushed to the right */}
          <div className="ml-auto">
            <button
              onClick={onDelete}
              className="flex items-center gap-1.5 p-1.5 rounded-md transition-default text-foreground-muted hover:text-error hover:bg-error-subtle"
              title="Delete relationship"
            >
              <Trash2 size={12} />
              <span className="text-xs">Delete</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
});
