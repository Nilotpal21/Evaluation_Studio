/**
 * StageContextMenu — right-click context menu for pipeline stage nodes.
 *
 * Actions: Configure, Move Left, Move Right, Duplicate, Remove.
 * Follows the same pattern as FileContextMenu — fixed positioning at click coords,
 * click-outside close, keyboard navigation, proper ARIA roles.
 */

'use client';

import { useCallback, useEffect, useRef } from 'react';
import { Settings2, ArrowLeft, ArrowRight, Copy, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

export interface StageContextMenuProps {
  x: number;
  y: number;
  stageId: string;
  flowId: string;
  canMoveLeft: boolean;
  canMoveRight: boolean;
  onConfigure: () => void;
  onMoveLeft: () => void;
  onMoveRight: () => void;
  onDuplicate: () => void;
  onRemove: () => void;
  onClose: () => void;
}

export function StageContextMenu({
  x,
  y,
  canMoveLeft,
  canMoveRight,
  onConfigure,
  onMoveLeft,
  onMoveRight,
  onDuplicate,
  onRemove,
  onClose,
}: StageContextMenuProps) {
  const t = useTranslations('search_ai.pipeline');
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as HTMLElement)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const items = [
    {
      label: t('v2_context_menu_configure'),
      icon: <Settings2 className="h-3.5 w-3.5" />,
      onClick: onConfigure,
      disabled: false,
      danger: false,
    },
    {
      label: t('v2_context_menu_move_left'),
      icon: <ArrowLeft className="h-3.5 w-3.5" />,
      onClick: onMoveLeft,
      disabled: !canMoveLeft,
      danger: false,
    },
    {
      label: t('v2_context_menu_move_right'),
      icon: <ArrowRight className="h-3.5 w-3.5" />,
      onClick: onMoveRight,
      disabled: !canMoveRight,
      danger: false,
    },
    {
      label: t('v2_context_menu_duplicate'),
      icon: <Copy className="h-3.5 w-3.5" />,
      onClick: onDuplicate,
      disabled: false,
      danger: false,
    },
    {
      label: t('v2_context_menu_remove'),
      icon: <Trash2 className="h-3.5 w-3.5" />,
      onClick: onRemove,
      disabled: false,
      danger: true,
    },
  ];

  const handleItemClick = useCallback(
    (action: () => void) => {
      action();
      onClose();
    },
    [onClose],
  );

  return (
    <div
      ref={menuRef}
      role="menu"
      className="fixed z-50 min-w-[180px] rounded-lg border border-default bg-background-elevated py-1 shadow-lg"
      style={{ left: x, top: y }}
    >
      {items.map((item) => (
        <button
          key={item.label}
          role="menuitem"
          disabled={item.disabled}
          onClick={() => handleItemClick(item.onClick)}
          className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-xs transition-colors ${
            item.disabled
              ? 'cursor-not-allowed text-foreground-muted/50'
              : item.danger
                ? 'text-error hover:bg-error/10'
                : 'text-foreground hover:bg-background-muted'
          }`}
        >
          {item.icon}
          {item.label}
        </button>
      ))}
    </div>
  );
}
