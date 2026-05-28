'use client';

/**
 * VirtualList Component
 *
 * Generic virtualized list using @tanstack/react-virtual.
 * Renders only visible items + a configurable overscan buffer,
 * keeping DOM node count constant regardless of list length.
 *
 * Supports dynamic item measurement via `ref={virtualizer.measureElement}`.
 */

import { useRef, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

interface VirtualListProps<T> {
  items: T[];
  /** Estimated height (px) of each item — used before measurement. */
  estimateSize: number;
  /** Render function for each item. */
  renderItem: (item: T, index: number) => ReactNode;
  /** CSS class applied to the scrollable container. */
  className?: string;
  /** Number of items to render above/below the visible window. */
  overscan?: number;
}

export function VirtualList<T>({
  items,
  estimateSize,
  renderItem,
  className,
  overscan = 5,
}: VirtualListProps<T>) {
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => estimateSize,
    overscan,
  });

  return (
    <div ref={parentRef} className={className} style={{ overflow: 'auto' }}>
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualizer.getVirtualItems().map((virtualItem) => (
          <div
            key={virtualItem.key}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${virtualItem.start}px)`,
            }}
            data-index={virtualItem.index}
            ref={virtualizer.measureElement}
          >
            {renderItem(items[virtualItem.index], virtualItem.index)}
          </div>
        ))}
      </div>
    </div>
  );
}
