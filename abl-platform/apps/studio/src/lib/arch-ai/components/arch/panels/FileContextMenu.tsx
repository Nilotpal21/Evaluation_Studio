'use client';

/**
 * FileContextMenu — B03 Phase 3: Right-click context menu for files
 * in the artifact panel. Menu items filtered by media type.
 * Arrow key navigation, Escape closes.
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { Download, Eye, EyeOff, Trash2, Copy, FileText } from 'lucide-react';
import { clsx } from 'clsx';

interface FileContextMenuProps {
  file: {
    name: string;
    mediaType: string;
    size: number;
    blobId: string;
    status: string;
  };
  position: { x: number; y: number };
  onClose: () => void;
  onAction: (action: string, blobId: string) => void;
}

interface MenuItem {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  danger?: boolean;
  dividerBefore?: boolean;
}

function getMenuItems(mediaType: string): MenuItem[] {
  const items: MenuItem[] = [];

  // Images: View
  if (mediaType.startsWith('image/')) {
    items.push({ id: 'view', label: 'View', icon: Eye });
  }

  // Code/YAML/JSON: Copy content
  const copyableTypes = [
    'application/json',
    'application/x-yaml',
    'text/yaml',
    'text/plain',
    'text/markdown',
    'text/javascript',
    'text/typescript',
    'text/html',
    'text/css',
  ];
  const isCodeFile =
    copyableTypes.includes(mediaType) ||
    mediaType.startsWith('text/') ||
    mediaType.includes('yaml') ||
    mediaType.includes('json');
  if (isCodeFile) {
    items.push({ id: 'copy', label: 'Copy content', icon: Copy });
  }

  // PDF: View PDF
  if (mediaType === 'application/pdf') {
    items.push({ id: 'view-pdf', label: 'View PDF', icon: FileText });
  }

  // All files: Download, Exclude/Include toggle, Delete
  items.push({ id: 'download', label: 'Download', icon: Download });
  items.push({ id: 'toggle-exclude', label: 'Exclude', icon: EyeOff });
  items.push({
    id: 'delete',
    label: 'Delete',
    icon: Trash2,
    danger: true,
    dividerBefore: true,
  });

  return items;
}

export function FileContextMenu({ file, position, onClose, onAction }: FileContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const items = getMenuItems(file.mediaType);

  // Close on click outside
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    // Delay to avoid closing immediately from the right-click event
    const timer = setTimeout(() => {
      document.addEventListener('click', handleClick);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('click', handleClick);
    };
  }, [onClose]);

  // Keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setActiveIndex((prev) => (prev + 1) % items.length);
          break;
        case 'ArrowUp':
          e.preventDefault();
          setActiveIndex((prev) => (prev - 1 + items.length) % items.length);
          break;
        case 'Enter':
        case ' ':
          e.preventDefault();
          onAction(items[activeIndex].id, file.blobId);
          onClose();
          break;
        case 'Escape':
          e.preventDefault();
          onClose();
          break;
      }
    },
    [items, activeIndex, file.blobId, onAction, onClose],
  );

  // Focus menu on mount
  useEffect(() => {
    menuRef.current?.focus();
  }, []);

  // Clamp position to viewport
  const style: React.CSSProperties = {
    position: 'fixed',
    left: position.x,
    top: position.y,
    zIndex: 50,
  };

  return (
    <div
      ref={menuRef}
      role="menu"
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      style={style}
      className={clsx(
        'min-w-[180px] rounded-lg border border-border bg-background-elevated py-1 shadow-lg',
        'focus:outline-none',
      )}
    >
      {items.map((item, index) => {
        const Icon = item.icon;
        return (
          <div key={item.id}>
            {item.dividerBefore && <div className="my-1 border-t border-border-muted" />}
            <button
              role="menuitem"
              type="button"
              tabIndex={-1}
              onClick={() => {
                onAction(item.id, file.blobId);
                onClose();
              }}
              onMouseEnter={() => setActiveIndex(index)}
              className={clsx(
                'flex w-full items-center gap-2.5 px-3 py-1.5 text-sm transition-colors',
                index === activeIndex && 'bg-foreground/[0.06]',
                item.danger
                  ? 'text-error hover:bg-error/10'
                  : 'text-foreground/80 hover:bg-foreground/[0.06]',
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span>{item.label}</span>
            </button>
          </div>
        );
      })}
    </div>
  );
}
