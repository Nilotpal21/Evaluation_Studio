'use client';

/**
 * ImageLightbox — B03 Phase 3: Full-screen image viewer with metadata bar.
 * Rendered via React portal to document.body.
 * Focus trap: tab cycles within modal. Escape closes.
 */

import { useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { clsx } from 'clsx';

interface ImageLightboxProps {
  src: string;
  alt: string;
  name: string;
  dimensions?: { width: number; height: number };
  onClose: () => void;
}

export function ImageLightbox({ src, alt, name, dimensions, onClose }: ImageLightboxProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  // Focus close button on mount
  useEffect(() => {
    closeBtnRef.current?.focus();
  }, []);

  // Escape key closes
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Focus trap: tab cycles within the modal
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Tab' && dialogRef.current) {
      const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
  }, []);

  // Click on backdrop closes
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) {
        onClose();
      }
    },
    [onClose],
  );

  const content = (
    <div
      ref={dialogRef}
      role="dialog"
      aria-label="Image viewer"
      aria-modal="true"
      onKeyDown={handleKeyDown}
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-overlay"
      onClick={handleBackdropClick}
    >
      {/* Close button */}
      <button
        ref={closeBtnRef}
        type="button"
        onClick={onClose}
        aria-label="Close image viewer"
        className={clsx(
          'absolute right-4 top-4 z-10 flex h-10 w-10 items-center justify-center',
          'rounded-full bg-foreground/10 text-foreground/80 transition-colors',
          'hover:bg-foreground/20 focus:outline-none focus:ring-2 focus:ring-border-focus',
        )}
      >
        <X className="h-5 w-5" />
      </button>

      {/* Image */}
      <div className="flex max-h-[80vh] max-w-[90vw] items-center justify-center">
        <img src={src} alt={alt} className="max-h-[80vh] max-w-[90vw] rounded-lg object-contain" />
      </div>

      {/* Metadata bar */}
      <div className="mt-4 flex items-center gap-4 rounded-lg bg-foreground/10 px-4 py-2 text-sm text-foreground/70">
        <span className="font-medium text-foreground/90">{name}</span>
        {dimensions && (
          <span>
            {dimensions.width} &times; {dimensions.height}
          </span>
        )}
      </div>
    </div>
  );

  if (typeof document === 'undefined') return null;
  return createPortal(content, document.body);
}
