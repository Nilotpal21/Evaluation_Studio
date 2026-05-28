'use client';

/**
 * FloatingDebugPanel
 *
 * A draggable, resizable floating panel that contains DebugTabs.
 * Can be toggled between docked sidebar and floating modes.
 */

import { useCallback, useRef, useState } from 'react';
import { motion, useDragControls } from 'framer-motion';
import { GripHorizontal, Minimize2, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { DebugTabs } from './DebugTabs';
import { useObservatoryStore } from '../../store/observatory-store';

export function FloatingDebugPanel() {
  const debugPanelPosition = useObservatoryStore((s) => s.debugPanelPosition);
  const debugPanelSize = useObservatoryStore((s) => s.debugPanelSize);
  const setDebugPanelPosition = useObservatoryStore((s) => s.setDebugPanelPosition);
  const setDebugPanelSize = useObservatoryStore((s) => s.setDebugPanelSize);
  const setDebugPanelMode = useObservatoryStore((s) => s.setDebugPanelMode);
  const setDebugPanelOpen = useObservatoryStore((s) => s.setDebugPanelOpen);

  const t = useTranslations('observatory.floating_panel');
  const dragControls = useDragControls();
  const resizing = useRef(false);

  const handleDock = useCallback(() => {
    setDebugPanelMode('docked');
  }, [setDebugPanelMode]);

  const handleClose = useCallback(() => {
    setDebugPanelOpen(false);
    setDebugPanelMode('docked');
  }, [setDebugPanelOpen, setDebugPanelMode]);

  const onResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      resizing.current = true;

      const startX = e.clientX;
      const startY = e.clientY;
      const startW = debugPanelSize.width;
      const startH = debugPanelSize.height;

      const onMouseMove = (ev: MouseEvent) => {
        if (!resizing.current) return;
        setDebugPanelSize({
          width: startW + (ev.clientX - startX),
          height: startH + (ev.clientY - startY),
        });
      };

      const onMouseUp = () => {
        resizing.current = false;
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
      document.body.style.cursor = 'nwse-resize';
      document.body.style.userSelect = 'none';
    },
    [debugPanelSize, setDebugPanelSize],
  );

  return (
    <motion.div
      drag
      dragControls={dragControls}
      dragListener={false}
      dragMomentum={false}
      dragElastic={0}
      onDragEnd={(_e, info) => {
        setDebugPanelPosition({
          x: debugPanelPosition.x + info.offset.x,
          y: debugPanelPosition.y + info.offset.y,
        });
      }}
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ duration: 0.15 }}
      className="fixed z-50 flex flex-col bg-background border border-default rounded-xl shadow-xl overflow-hidden"
      style={{
        left: debugPanelPosition.x,
        top: debugPanelPosition.y,
        width: debugPanelSize.width,
        height: debugPanelSize.height,
      }}
    >
      {/* Title bar — drag handle */}
      <div
        onPointerDown={(e) => dragControls.start(e)}
        className="flex items-center justify-between px-3 py-2 bg-background-subtle border-b border-default cursor-grab active:cursor-grabbing select-none shrink-0"
      >
        <div className="flex items-center gap-2 text-sm font-medium text-muted">
          <GripHorizontal className="w-4 h-4 text-subtle" />
          <span>{t('title')}</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={handleDock}
            className="p-1 text-muted hover:text-foreground hover:bg-background-muted rounded transition-default"
            title={t('dock_to_sidebar')}
          >
            <Minimize2 className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={handleClose}
            className="p-1 text-muted hover:text-foreground hover:bg-background-muted rounded transition-default"
            title={t('close_debug_panel')}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-hidden">
        <DebugTabs className="h-full" />
      </div>

      {/* Resize handle — bottom-right corner */}
      <div
        onMouseDown={onResizeStart}
        className="absolute bottom-0 right-0 w-4 h-4 cursor-nwse-resize"
        title={t('resize')}
      >
        <svg className="w-4 h-4 text-subtle" viewBox="0 0 16 16" fill="currentColor">
          <path d="M14 14H12V12H14V14ZM14 10H12V8H14V10ZM10 14H8V12H10V14ZM14 6H12V4H14V6ZM10 10H8V8H10V10ZM6 14H4V12H6V14Z" />
        </svg>
      </div>
    </motion.div>
  );
}
